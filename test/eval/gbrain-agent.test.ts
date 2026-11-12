/**
 * The gbrain agent arm (SOTA loop decision D2a, step 9), keyless: the neutral MCP adapter (eval/runner/systems/mcp-tools.ts),
 * the import and text checks on the new modules, the parity spec against both agents' real requests and receipts, the
 * SOTA dev cells in the generated manifest, and a two-item smoke of both dev cells through the q1 cell runner. No test
 * reaches a provider: globalThis.fetch throws and counts while these run, provider calls go to in-process stubs or
 * scripted models, and gbrain runs on hash vectors with its reranker off.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { ScriptedModel } from '../../eval/runner/cat40/loop.ts';
import { importGbrain, resolveGbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import type { Corpus, MemoryQuestion } from '../../eval/runner/memory-qa/corpus.ts';
import type { ChatLike, ChatResult } from '../../eval/runner/memory-qa/qa-v2.ts';
import { runCell, systemFor } from '../../eval/runner/q1/cell.ts';
import { ALL_SETS, buildManifest, definitionProblems, frontierJudgesFor, SOTA_DEV_CONVERSATIONS, SOTA_DEV_IDS, type CellDefinition } from '../../eval/runner/q1/cells/definitions.ts';
import { ScoreboardError } from '../../eval/runner/q1/scoreboard-errors.ts';
import { ANSWERABLE, loadClasses } from '../../eval/runner/sota/answerability.ts';
import { FILE_AGENT_EFFORT, FILE_AGENT_MAX_TURNS, FILE_AGENT_SYSTEM, FileAgentSystem, PROSE_ANSWER_TOOL } from '../../eval/runner/systems/file-agent.ts';
import { AGENT_ARM_PARITY, GBRAIN_AGENT_SYSTEM, GBRAIN_AGENT_TOOLS, GbrainAgentSystem } from '../../eval/runner/systems/gbrain-agent.ts';
import { mcpToolArm, type McpToolServer } from '../../eval/runner/systems/mcp-tools.ts';
import { Sanitizer } from '../../eval/runner/systems/sanitize.ts';

const ROOT = resolve(import.meta.dir, '../..');
const tmp = mkdtempSync(join(tmpdir(), 'gbrain-agent-'));
const realFetch = globalThis.fetch;
const network: string[] = [];
beforeAll(() => { globalThis.fetch = (async (input: string | URL | Request) => { network.push(String(input instanceof Request ? input.url : input)); throw new Error('no network in keyless tests'); }) as unknown as typeof fetch; });
afterAll(() => { globalThis.fetch = realFetch; rmSync(tmp, { recursive: true, force: true }); });

const raw = JSON.parse(readFileSync(join(ROOT, 'test/eval/fixtures/q1-cell/locomo-shaped.json'), 'utf8')) as { conversations: Corpus['conversations']; questions: MemoryQuestion[] };
const corpus: Corpus = { benchmark: 'fixture', conversations: raw.conversations, questions: raw.questions, source: { name: 'LoCoMo-shaped fixture (invented)', files: [{ path: 'test/eval/fixtures/q1-cell/locomo-shaped.json', sha256: 'fixture' }], revision: 'repo', license: 'MIT' } };
const sotaCells = () => buildManifest().addon_cells!.filter(c => c.id.startsWith('sota-dev.'));
/** Personal names and private-agent words that no new module, prompt or model-visible request may carry. */
const BANNED = [/garry/i, /wintermute/i, /\bYC\b/, /y combinator/i, /openclaw/i, /alphaclaw/i, /telegram/i];
const readersOf = (c: CellDefinition) => c.arms.flatMap(a => a.readers);

describe('neutral MCP adapter', () => {
  const server = (calls: string[] = []): McpToolServer => ({
    listTools: async () => [{ name: 'lookup', description: 'Look a thing up.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }, { name: 'erase', inputSchema: { type: 'object' } }],
    callTool: async (name, args) => { calls.push(name); return args.fail ? { content: [{ type: 'text', text: 'not found' }], isError: true } : { content: [{ type: 'text', text: 'one' }, { type: 'image' }, { type: 'text', text: 'two' }] }; },
  });

  test('offers only the allowed tools with the server\'s own names, descriptions and schemas, and writes nothing', async () => {
    const arm = await mcpToolArm('x', server(), ['lookup']);
    expect(arm.tools()).toEqual([{ name: 'lookup', description: 'Look a thing up.', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }]);
    expect(arm.writeTools()).toEqual([]);
    expect(arm.systemHint()).toBe('');
  });

  test('joins text blocks, throws a result marked isError, and refuses any other name before the server sees it', async () => {
    const calls: string[] = [];
    const arm = await mcpToolArm('x', server(calls), ['lookup']);
    expect(await arm.call('lookup', { q: 'a' })).toBe('one\ntwo');
    await expect(arm.call('lookup', { fail: true })).rejects.toThrow('not found');
    await expect(arm.call('erase', {})).rejects.toThrow('unknown tool erase');
    expect(calls).toEqual(['lookup', 'lookup']);
  });

  test('refuses to build when the server lists no tool of an allowed name', async () => {
    await expect(mcpToolArm('x', server(), ['lookup', 'search'])).rejects.toThrow('lists no search tool');
  });
});

describe('no live-recall import, no personal text', () => {
  const NEW_MODULES = ['eval/runner/systems/mcp-tools.ts', 'eval/runner/systems/gbrain-agent.ts'];

  /** Every repository module the entries import, transitively (relative imports, dynamic ones included). */
  function importGraph(entries: string[]): Set<string> {
    const seen = new Set<string>();
    const scan = new Bun.Transpiler({ loader: 'ts' });
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const imp of scan.scanImports(readFileSync(file, 'utf8'))) {
        if (!imp.path.startsWith('.')) continue;
        const target = resolve(dirname(file), imp.path);
        if (target.startsWith(ROOT + '/') && !target.includes('/node_modules/') && existsSync(target) && /\.[cm]?[jt]s$/.test(target)) walk(target);
      }
    };
    for (const e of entries) walk(resolve(ROOT, e));
    return seen;
  }

  test('nothing the adapter or the gbrain agent imports, at any depth, is under eval/runner/live-recall', () => {
    const graph = [...importGraph(NEW_MODULES)].map(f => f.slice(ROOT.length + 1));
    expect(graph).toContain('eval/runner/systems/file-agent.ts');
    expect(graph.filter(f => f.startsWith('eval/runner/live-recall/'))).toEqual([]);
  });

  test('the new modules and the BEAM prompt carry no personal names or private conventions', () => {
    for (const f of NEW_MODULES) for (const re of BANNED) expect({ f, hit: re.exec(readFileSync(join(ROOT, f), 'utf8'))?.[0] ?? null }).toEqual({ f, hit: null });
    for (const re of BANNED) expect(re.test(GBRAIN_AGENT_SYSTEM)).toBe(false);
  });
});

/** A provider stub: every model call answers `submit_answer` at once, in the provider's own shape; it records each request. */
function submitAtOnce(bodies: Array<{ url: string; body: any }>): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push({ url: String(url), body });
    const u = String(url);
    return Response.json(u.includes('anthropic') ? { content: [{ type: 'tool_use', id: 't1', name: 'submit_answer', input: { answer: 'done' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 2 } }
      : u.includes('openai') ? { id: 'r1', status: 'completed', output: [{ type: 'function_call', call_id: 'c1', name: 'submit_answer', arguments: JSON.stringify({ answer: 'done' }) }], usage: { input_tokens: 10, output_tokens: 2 } }
      : { id: 'c', model: 'particle-ai/particle-1', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'submit_answer', arguments: JSON.stringify({ answer: 'done' }) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
  }) as unknown as typeof fetch;
}

describe('parity with the file agent (AGENT_ARM_PARITY)', () => {
  const ns = 'ns-00000000000000a1';
  const session = { source_id: 'src-00000000000000a1', turns: [{ role: 'user' as const, speaker: 'User', content: 'my dog is called Rex' }] };
  const question = { text: 'What is my dog called?', query_time: '2026/01/03' };
  let saved: string | undefined;
  beforeAll(() => { saved = process.env.PARTICLE_API_KEY; process.env.PARTICLE_API_KEY = 'test-key'; });
  afterAll(() => { if (saved === undefined) delete process.env.PARTICLE_API_KEY; else process.env.PARTICLE_API_KEY = saved; });

  test('the spec states the code\'s settings and the dev cells\' readers', async () => {
    expect(AGENT_ARM_PARITY).toMatchObject({ max_turns: FILE_AGENT_MAX_TURNS, effort: FILE_AGENT_EFFORT, max_tool_chars: null, submit_tool: PROSE_ANSWER_TOOL.name });
    expect(FILE_AGENT_MAX_TURNS).toBe(40);
    expect(FILE_AGENT_EFFORT).toBe('medium');
    for (const c of sotaCells()) expect(readersOf(c).sort()).toEqual([...AGENT_ARM_PARITY.readers].sort());
    expect(AGENT_ARM_PARITY.tools['gbrain-defaults']).toEqual([...GBRAIN_AGENT_TOOLS]);
    const sentences = (s: string) => s.split('. ');
    expect(sentences(GBRAIN_AGENT_SYSTEM)[0]).toBe(sentences(FILE_AGENT_SYSTEM)[0]);
  });

  test('both agents send the same request for every reader except the prompt and the tools; gbrain\'s tools are its own list; receipts land in each lane', async () => {
    const fileBodies: Array<{ url: string; body: any }> = [];
    const gbrainBodies: Array<{ url: string; body: any }> = [];
    const file = new FileAgentSystem({ workDir: join(tmp, 'parity-file'), fetchImpl: submitAtOnce(fileBodies) });
    const gbrain = new GbrainAgentSystem({ workDir: join(tmp, 'parity-gbrain'), embed: 'hash', fetchImpl: submitAtOnce(gbrainBodies) });
    await file.reset(ns);
    await gbrain.reset(ns);
    for (const sys of [file, gbrain]) await sys.ingestSession(ns, session, '2026-01-02T00:00:00Z');
    for (const reader of AGENT_ARM_PARITY.readers) {
      const opts = { reader, replicate: 0, answer_id: createHash('sha256').update(reader).digest('hex') };
      const [a, b] = [await file.answer(ns, question, opts), await gbrain.answer(ns, question, opts)];
      expect(a).toMatchObject({ text: 'done', stop_reason: 'submitted', outcome: 'scored', turns: 1, opened_source_ids: [] });
      expect(b).toMatchObject({ text: 'done', stop_reason: 'submitted', outcome: 'scored', turns: 1, opened_source_ids: [] });
    }
    expect(fileBodies.map(b => b.url)).toEqual(gbrainBodies.map(b => b.url));
    for (const re of BANNED) expect(re.exec(JSON.stringify(gbrainBodies))?.[0] ?? null).toBeNull();
    const gut = resolveGbrainUnderTest(null);
    const { buildToolDefs } = await importGbrain<{ buildToolDefs: (ops: unknown[], o?: object) => Array<{ name: string; description: string; inputSchema: object }> }>(gut, 'src/mcp/tool-defs.ts');
    const { OPERATION_MANIFEST } = await importGbrain<{ OPERATION_MANIFEST: Array<{ name: string }> }>(gut, 'src/core/operation-manifest.generated.ts');
    const own = GBRAIN_AGENT_TOOLS.map(n => buildToolDefs(OPERATION_MANIFEST.filter(o => o.name === n), { strictParams: false })[0]);
    for (const [i, { url, body: f }] of fileBodies.entries()) {
      const g = gbrainBodies[i].body;
      const names = (b: any) => b.tools.map((t: any) => t.name ?? t.function?.name);
      expect(names(f)).toEqual([...AGENT_ARM_PARITY.tools['baseline-file-agent'], 'submit_answer']);
      expect(names(g)).toEqual([...GBRAIN_AGENT_TOOLS, 'submit_answer']);
      const strip = (b: any) => { const { tools: _t, system: _s, instructions: _i, prompt_cache_key: _k, ...rest } = b; return { ...rest, ...(rest.messages ? { messages: rest.messages.filter((m: any) => m.role !== 'system') } : {}) }; };
      expect(strip(g)).toEqual(strip(f));
      if (url.includes('anthropic')) {
        const text = (x: any): string => typeof x === 'string' ? x : x.map((b: any) => b.text).join('');
        expect(f).toMatchObject({ max_tokens: AGENT_ARM_PARITY.output_tokens.anthropic, output_config: { effort: 'medium' } });
        expect([text(f.system), text(g.system)]).toEqual([FILE_AGENT_SYSTEM, GBRAIN_AGENT_SYSTEM]);
        expect(text(f.messages[0].content)).toBe(`Current Date: ${question.query_time}\nQuestion: ${question.text}`);
        expect(g.tools.slice(0, 3)).toEqual(own.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema })));
      } else if (url.includes('openai')) {
        expect(f).toMatchObject({ max_output_tokens: AGENT_ARM_PARITY.output_tokens.openai, reasoning: { effort: 'medium' }, instructions: FILE_AGENT_SYSTEM });
        expect(g.instructions).toBe(GBRAIN_AGENT_SYSTEM);
      } else {
        expect(f).toMatchObject({ max_completion_tokens: AGENT_ARM_PARITY.output_tokens.particle, reasoning_effort: 'medium' });
        expect(g.messages[0]).toEqual({ role: 'system', content: GBRAIN_AGENT_SYSTEM });
      }
    }
    const receipts = (p: string) => readFileSync(p, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const [rf, rg] = [receipts(file.receiptsPath), receipts(gbrain.receiptsPath)];
    expect(rf).toHaveLength(AGENT_ARM_PARITY.readers.length);
    expect(rf.every(r => r.lane === AGENT_ARM_PARITY.receipts['baseline-file-agent'])).toBe(true);
    expect(rg.every(r => r.lane === AGENT_ARM_PARITY.receipts['gbrain-defaults'])).toBe(true);
    expect(rg.map(r => [r.model, r.question_id, r.attempt, r.turn, r.request])).toEqual(rf.map(r => [r.model, r.question_id, r.attempt, r.turn, r.request]));
    const [cf, cg] = [await file.capabilities(), await gbrain.capabilities()];
    expect([cg.max_turns, cg.effort]).toEqual([cf.max_turns, cf.effort]);
    expect(cg.tools).toEqual([...GBRAIN_AGENT_TOOLS]);
    await file.close();
    await gbrain.close();
    expect(network).toEqual([]);
  }, 120_000);
});

describe('SOTA dev cells', () => {
  test('both cells are valid, in process, outside the counted list, and select every answerable question of the four dev conversations', () => {
    const m = buildManifest();
    const kinds = new Set((JSON.parse(readFileSync(join(ROOT, 'eval/systems/kinds.json'), 'utf8')) as { kinds: Array<{ id: string }> }).kinds.map(k => k.id));
    const cells = m.addon_cells!.filter(c => c.set === 'SOTA-dev');
    expect(cells.map(c => c.id)).toEqual(['sota-dev.baseline-file-agent.baseline', 'sota-dev.gbrain-defaults.agent-tools']);
    for (const c of cells) {
      expect(definitionProblems(c, kinds)).toEqual([]);
      expect(c).toMatchObject({ runner: 'in-process', set: 'SOTA-dev', block: 'SOTA-dev', benchmark: 'beam-1m', split: 'dev', only_conversations: SOTA_DEV_CONVERSATIONS, selection: { kind: 'ids', ids: SOTA_DEV_IDS } });
      expect(c.arms.map(a => [a.id, a.mode, a.readers, a.frontier?.judges])).toEqual([
        ['whole-agent', 'agent', ['anthropic:claude-opus-5-5', 'openai:gpt-6.1-sol'], ['anthropic:claude-opus-5-5', 'openai:gpt-6.1-sol']],
        ['whole-agent-particle', 'agent', ['particle:particle-1'], ['anthropic:claude-opus-5-5']],
      ]);
      expect(frontierJudgesFor(c.arms[1]!, 'particle:particle-1')).toEqual(['anthropic:claude-opus-5-5']);
      expect(m.cells.some(x => x.id === c.id)).toBe(false);
    }
    const classes = loadClasses('beam-1m')!;
    expect(SOTA_DEV_IDS).toHaveLength(66);
    expect(SOTA_DEV_IDS).toEqual([...classes].filter(([id, c]) => SOTA_DEV_CONVERSATIONS.includes(id.split(':')[0]) && ANSWERABLE.includes(c)).map(([id]) => id).sort());
    expect(ALL_SETS['SOTA-dev'].questions).toBe(SOTA_DEV_IDS.length);
    const pool = (JSON.parse(readFileSync(join(ROOT, 'eval/data/nightly/devset-v2.json'), 'utf8')) as { suites: Array<{ id: string; items: Array<{ id: string }> }> }).suites.find(s => s.id === 'beam-1m-hard')!.items.map(i => i.id);
    const counts = new Map<string, number>();
    for (const id of pool) counts.set(id.split(':')[0], (counts.get(id.split(':')[0]) ?? 0) + 1);
    const ranked = [...counts].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1)).slice(0, 4).map(([c]) => c).sort();
    expect([...SOTA_DEV_CONVERSATIONS].sort()).toEqual(ranked);
    expect(SOTA_DEV_IDS.every(id => pool.includes(id))).toBe(true);
    expect(pool.filter(id => SOTA_DEV_CONVERSATIONS.includes(id.split(':')[0])).sort()).toEqual(SOTA_DEV_IDS);
  });

  test('the in-process gbrain-defaults cell builds the gbrain agent, and refuses a metering proxy', () => {
    const def = sotaCells()[1];
    const sanitizer = new Sanitizer(corpus, 'test');
    expect(systemFor(def, { out: join(tmp, 'system-for'), embed: 'hash' }, sanitizer)).toBeInstanceOf(GbrainAgentSystem);
    expect(() => systemFor(def, { out: join(tmp, 'system-for'), providerProxy: 'http://127.0.0.1:1' }, sanitizer)).toThrow(ScoreboardError);
  });
});

describe('two-item keyless smoke through the q1 cell runner', () => {
  const STOP = new Set(['what', 'when', 'where', 'which', 'did', 'the', 'and', 'how', 'who']);
  const words = (text: string) => text.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(w => w.length >= 4 && !STOP.has(w));
  const answerFrom = (read: string | undefined) => ({ name: 'submit_answer', args: { answer: read ? `From the sessions: ${read}` : 'The history does not say.' } });
  const fileAgent = (q: { text: string }): ScriptedModel => history => {
    if (!history.length) return { name: 'grep', args: { pattern: `\\b(${words(q.text).join('|')})\\b`, files_only: true, ignore_case: true } };
    const hit = history[0].result === 'No matches.' ? undefined : history[0].result.split('\n')[0];
    return history.length === 1 && hit ? { name: 'read_file', args: { path: hit } } : answerFrom(history[1]?.result);
  };
  const gbrainAgent = (q: { text: string }): ScriptedModel => history => {
    if (!history.length) return { name: 'search', args: { query: words(q.text).join(' ') } };
    const rows = JSON.parse(history[0].result.split('\n')[0]) as Array<{ slug: string; chunk_text: string }>;
    const slug = (rows.find(r => words(q.text).some(w => r.chunk_text.toLowerCase().includes(w))) ?? rows[0])?.slug;
    return history.length === 1 && slug ? { name: 'get_page', args: { slug } } : answerFrom(history[1]?.result);
  };
  const judge = (): ChatLike => ({
    async chat(_model, prompt): Promise<ChatResult> {
      const response = /Model Response: ([\s\S]*?)\n\n/.exec(prompt)?.[1] ?? '';
      const reference = /Correct Answer: ([\s\S]*?)\n\n/.exec(prompt)?.[1] ?? '';
      return { text: response.toLowerCase().includes(reference.toLowerCase()) ? 'yes' : 'no', input_tokens: 100, output_tokens: 1, cached: false, finish: null, usage: null, response_model: null, attempt_errors: [] };
    },
  });
  const ndjson = (path: string) => readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

  test('both SOTA dev cells, on two fixture questions in their place: every reader answers from the session it opened, judged by the canonical and per-reader frontier judges, nothing reaches a provider', async () => {
    const ids = ['conv-a:q003', 'conv-b:q003'];
    for (const cell of sotaCells()) {
      const def: CellDefinition = { ...cell, benchmark: 'locomo', canonical_instrument: 'locomo', selection: { kind: 'ids', ids }, only_conversations: ['conv-a', 'conv-b'] };
      const out = join(tmp, 'smoke', def.id);
      const system = def.system === 'gbrain-defaults'
        ? new GbrainAgentSystem({ workDir: join(out, 'brains'), embed: 'hash', scripted: gbrainAgent })
        : new FileAgentSystem({ workDir: join(out, 'trees'), scripted: fileAgent });
      const res = await runCell(def, { out, probeIntervalMs: 5, probeTimeoutMs: 2000 }, { corpus, system, judge: judge() });
      expect({ cell: def.id, status: res.status, stopped: res.stopped }).toEqual({ cell: def.id, status: 'complete', stopped: null });
      for (const arm of def.arms) {
        const dir = join(out, 'cells', arm.cell_id);
        const answers = ndjson(join(dir, 'answers.ndjson'));
        expect(answers).toHaveLength(ids.length * arm.readers.length);
        expect(answers.every(a => a.outcome === 'scored' && a.stop_reason === 'submitted')).toBe(true);
        expect(Object.fromEntries(answers.filter(a => a.reader === arm.readers[0]).map(a => [a.question_id, a.opened_source_ids]))).toEqual({ 'conv-a:q003': ['session_2'], 'conv-b:q003': ['session_3'] });
        const judgments = ndjson(join(dir, 'judgments.ndjson'));
        expect(judgments).toHaveLength(answers.length * 2);
        expect(judgments.every(j => j.outcome === 'scored' && j.score === 1)).toBe(true);
        expect([...new Set(judgments.filter(j => j.settings).map(j => j.judge))].sort()).toEqual(arm.frontier!.judges);
        const config = JSON.parse(readFileSync(join(dir, 'run-config.json'), 'utf8'));
        expect(config.reader.prompt_sha256).toBe(createHash('sha256').update(def.system === 'gbrain-defaults' ? GBRAIN_AGENT_SYSTEM : FILE_AGENT_SYSTEM).digest('hex'));
      }
    }
    expect(network).toEqual([]);
  }, 300_000);
});
