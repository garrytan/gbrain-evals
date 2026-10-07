/**
 * Q1 whole-system baselines, keyless: the file agent (uncapped ripgrep grep,
 * date-tree layout, no write tool, turn cap, evidence opened, scripted end to
 * end on the fixture), Cat 40's `FsArm` default pinned byte for byte, and the
 * true full-context baseline (reader windows, fit and refusal, per-conversation
 * prompt caching against a recorded fetch).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHAT_PRICE_OVERRIDES } from '../../eval/runner/budget-ledger.ts';
import { FileStore, FsArm, UNCAPPED_GREP_TOOL } from '../../eval/runner/cat40/arms.ts';
import { runAgent, SUBMIT_TOOL, type AgentRun, type ScriptedModel } from '../../eval/runner/cat40/loop.ts';
import { DecideError } from '../../eval/runner/decisions/errors.ts';
import { generateLadderWorld } from '../../eval/generators/model-ladder-gen.ts';
import { loadFixture } from '../../eval/runner/memory-qa/corpus.ts';
import { readerPrompt } from '../../eval/runner/memory-qa/qa.ts';
import { answerFullContext, checkFit, FRONTIER_READERS, FullContextSystem, READER_WINDOWS, splitForCache } from '../../eval/runner/systems/baselines.ts';
import { classifyRun, evidenceOpened, FILE_AGENT_MAX_TURNS, FileAgentSystem, layoutSessions, parseReader, PROSE_ANSWER_TOOL, proxiedFetch, ripgrep, type GrepLimitEvent } from '../../eval/runner/systems/file-agent.ts';
import { Sanitizer } from '../../eval/runner/systems/sanitize.ts';

const tmp = mkdtempSync(join(tmpdir(), 'file-agent-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function tree(name: string, files: Record<string, string>): string {
  const root = join(tmp, name);
  for (const [p, c] of Object.entries(files)) { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), c); }
  return root;
}

const req = (pattern: string, over: Partial<{ path: string; ignore_case: boolean; max_results: number | null; files_only: boolean }> = {}) =>
  ({ pattern, path: '', ignore_case: true, max_results: null, files_only: false, ...over });

describe('Cat 40 FsArm default is unchanged', () => {
  test('tools, hint, write tools and capped grep match the pre-Q1 arm byte for byte', async () => {
    const world = generateLadderWorld();
    const out: unknown[] = [];
    for (const name of ['fs', 'fs-acl'] as const) {
      const arm = new FsArm(name, FileStore.fromWorld(world));
      out.push(arm.systemHint(), arm.tools(), arm.writeTools());
      out.push(await arm.call('list_dir', { path: '.' }));
      out.push(await arm.call('grep', { pattern: 'the' }));
      out.push(await arm.call('grep', { pattern: 'a', max_results: 500 }));
      out.push(await arm.call('grep', { pattern: 'billing', ignore_case: false, max_results: 3 }));
      out.push(await arm.call('grep', { pattern: '(' }));
      const big = new FsArm(name, new FileStore(new Map([['long.md', `${'x'.repeat(400)}\n`.repeat(250)]])));
      out.push(await big.call('grep', { pattern: 'x', max_results: 1000 }));
      out.push(await arm.call('write_file', { path: 'notes/n.md', content: 'hi' }), await arm.call('read_file', { path: 'notes/n.md' }));
    }
    // Digest of the same probe against eval/runner/cat40/arms.ts at evals/q1-scoreboard 7424a6c, before the uncapped option existed.
    expect(createHash('sha256').update(JSON.stringify(out)).digest('hex')).toBe('4ce53ce45e90c34cb342e33284d1fb5b75db5cb73457b26c6684ee12f47ca00e');
  });

  test('the default grep still caps at 200 matches and 300 characters', async () => {
    const arm = new FsArm('fs', new FileStore(new Map([['long.md', `${'x'.repeat(400)}\n`.repeat(250)]])));
    const r = await arm.call('grep', { pattern: 'x', max_results: 1000 });
    expect(r.split('\n').filter(l => l.startsWith('long.md:')).length).toBe(200);
    expect(r).toContain('…');
    expect(r).toContain('[50 more matches not shown]');
    expect(arm.tools().map(t => t.name)).toContain('write_file');
  });
});

describe('uncapped grep (ripgrep)', () => {
  const long = `${'y'.repeat(5000)} needle\n`;
  const root = tree('uncapped', { '2023/05/08/a.md': long.repeat(150), '2023/05/09/b.md': long.repeat(100), '2024/01/01/c.md': 'nothing here\n' });
  const store = new FileStore(new Map([['2023/05/08/a.md', long.repeat(150)], ['2023/05/09/b.md', long.repeat(100)], ['2024/01/01/c.md', 'nothing here\n']]));
  const arm = new FsArm('file-agent', store, { grep: ripgrep(root), write: false });

  test('every match, whole lines, no truncation marker and no "more matches" line', async () => {
    const r = await arm.call('grep', { pattern: 'needle' });
    const lines = r.split('\n');
    expect(lines.length).toBe(250);
    expect(lines.every(l => l.endsWith(`${'y'.repeat(5000)} needle`))).toBe(true);
    expect(r).not.toContain('…');
    expect(r).not.toMatch(/more matches not shown|truncated/);
    expect(lines[0].startsWith('2023/05/08/a.md:1:')).toBe(true);
    expect(lines[249].startsWith('2023/05/09/b.md:100:')).toBe(true);
  });

  test('agent-supplied max_results, files_only, path scope, case and no matches', async () => {
    expect((await arm.call('grep', { pattern: 'needle', max_results: 3 })).split('\n')).toHaveLength(3);
    expect(await arm.call('grep', { pattern: 'needle', files_only: true })).toBe('2023/05/08/a.md\n2023/05/09/b.md');
    expect(await arm.call('grep', { pattern: 'needle', files_only: true, max_results: 1 })).toBe('2023/05/08/a.md');
    expect(await arm.call('grep', { pattern: 'needle', path: '2023/05/09', files_only: true })).toBe('2023/05/09/b.md');
    expect(await arm.call('grep', { pattern: 'NEEDLE', ignore_case: false })).toBe('No matches.');
    expect((await arm.call('grep', { pattern: 'NEEDLE' })).split('\n')).toHaveLength(250);
    expect(await arm.call('grep', { pattern: 'needle', max_results: 0 })).toMatch(/positive number/);
    expect(await arm.call('grep', { pattern: '(' })).toMatch(/^grep error: /);
  });

  test('offers list_dir, grep and read_file only: no write tool, and the grep schema has no default cap', async () => {
    expect(arm.tools().map(t => t.name)).toEqual(['list_dir', 'grep', 'read_file']);
    expect(arm.writeTools()).toEqual([]);
    expect(arm.tools().find(t => t.name === 'grep')).toBe(UNCAPPED_GREP_TOOL);
    expect(JSON.stringify(UNCAPPED_GREP_TOOL)).not.toMatch(/Default 50|200/);
    await expect(arm.call('write_file', { path: 'x.md', content: 'x' })).rejects.toThrow(/unknown tool write_file/);
    expect(arm.systemHint()).not.toContain('write_file');
  });

  test('a catastrophic-backtracking pattern finishes: the engine is linear-time', async () => {
    const r = tree('redos', { 'a.md': `${'a'.repeat(5000)}b\n${'a'.repeat(40)}\n` });
    const t0 = performance.now();
    const out = await ripgrep(r)(req('^(a+)+$'));
    expect(out).toBe(`a.md:2:${'a'.repeat(40)}`);
    expect(performance.now() - t0).toBeLessThan(5000);
  });

  test('a pattern past the wall-time limit is cancelled and classified, with no partial output', async () => {
    const words = ['alpha', 'beta', 'gamma', 'delta', 'pebble', 'kitten'];
    const line = Array.from({ length: 200 }, (_, i) => words[(i * 7) % words.length]).join(' ');
    const r = tree('slow', { 'big.md': `${line}\n`.repeat(40_000) });
    const events: GrepLimitEvent[] = [];
    const out = await ripgrep(r, { wall_ms: 20, max_output_bytes: 1 << 30 }, e => events.push(e))(req('(?:\\p{L}{1,40}\\s?){20}\\d'));
    expect(out).toMatch(/^grep cancelled: it ran past the 0.02 s wall-time limit/);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('wall_time');
    expect(events[0].pattern).toBe('(?:\\p{L}{1,40}\\s?){20}\\d');
  });

  test('output past the memory limit is cancelled and classified, never cut', async () => {
    const events: GrepLimitEvent[] = [];
    const out = await ripgrep(root, { wall_ms: 60_000, max_output_bytes: 64 * 1024 }, e => events.push(e))(req('needle'));
    expect(out).toMatch(/^grep cancelled: its output passed the/);
    expect(out).not.toContain('needle');
    expect(events.map(e => e.kind)).toEqual(['memory']);
  });
});

describe('date-tree layout', () => {
  const turns = [{ role: 'user' as const, speaker: 'user', content: 'hello' }];
  test('YYYY/MM/DD/<opaque>.md, undated sessions take their batch date', () => {
    const files = layoutSessions('ns-0123456789abcdef', [
      { source_id: 'src-a', event_time: null, turns },
      { source_id: 'src-b', event_time: '2023-05-08T13:56:00', turns },
      { source_id: 'src-c', event_time: null, turns },
      { source_id: 'src-d', event_time: '2024-01-02T00:00:00', turns },
    ]);
    const bySrc = Object.fromEntries([...files].map(([p, f]) => [f.source_id, p]));
    expect(bySrc['src-a']).toMatch(/^2023\/05\/08\/[0-9a-f]{16}\.md$/);
    expect(bySrc['src-b']).toMatch(/^2023\/05\/08\/[0-9a-f]{16}\.md$/);
    expect(bySrc['src-c']).toMatch(/^2023\/05\/08\/[0-9a-f]{16}\.md$/);
    expect(bySrc['src-d']).toMatch(/^2024\/01\/02\/[0-9a-f]{16}\.md$/);
    expect(Object.values(bySrc).join(' ')).not.toContain('src-');
    expect(files.get(bySrc['src-b'])!.content).toBe('---\ndate: 2023-05-08T13:56:00\n---\nuser: hello\n');
    expect(files.get(bySrc['src-a'])!.content).toContain('date: unknown');
    expect([...layoutSessions('ns-x', [{ source_id: 'src-z', event_time: null, turns }]).keys()][0]).toMatch(/^undated\//);
  });

  test('list_dir at the root of a 6,000-session conversation lists years, not files', async () => {
    const sessions = Array.from({ length: 6000 }, (_, i) => ({ source_id: `src-${i}`, event_time: new Date(Date.UTC(2020, 0, 1) + i * 86_400_000 / 4).toISOString().slice(0, 19), turns }));
    const files = layoutSessions('ns-big', sessions);
    expect(files.size).toBe(6000);
    const arm = new FsArm('file-agent', new FileStore(new Map([...files].map(([p, f]) => [p, f.content]))), { write: false });
    expect(await arm.call('list_dir', { path: '.' })).toBe('2020/\n2021/\n2022/\n2023/\n2024/');
    expect((await arm.call('list_dir', { path: '2021/03' })).split('\n')).toHaveLength(31);
  });
});

describe('file agent end to end (scripted, fixture)', () => {
  const corpus = loadFixture();
  const san = new Sanitizer(corpus, 'file-agent-test');
  const STOP = new Set(['what', 'when', 'where', 'which', 'much', 'many', 'does', 'did', 'the', 'for', 'and', 'how', 'who', 'with', 'from', 'that', 'this', 'have', 'has']);
  const words = (text: string) => text.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(w => w.length >= 3 && !STOP.has(w));
  const searcher = (q: { text: string }): ScriptedModel => history => {
    if (!history.length) return { name: 'list_dir', args: { path: '.' } };
    if (history.length === 1) return { name: 'grep', args: { pattern: `\\b(${words(q.text).join('|')})\\b`, files_only: true } };
    const hits = history[1].result === 'No matches.' ? [] : history[1].result.split('\n');
    const read = history.length - 2;
    if (read < hits.length) return { name: 'read_file', args: { path: hits[read] } };
    const bodies = history.slice(2).map(h => h.result.split('\n').slice(3).join(' ')).join(' | ');
    return { name: 'submit_answer', args: { answer: hits.length ? `From the sessions: ${bodies}` : 'The conversations do not say.', sources: hits } };
  };

  test('ingests through the sanitizer, answers every question, records evidence opened evaluator-side', async () => {
    const sys = new FileAgentSystem({ workDir: join(tmp, 'agent'), scripted: searcher });
    const cap = await sys.capabilities();
    expect(cap.agent_surface.kind).toBe('native-agent');
    expect((cap.grep as Record<string, unknown>).default_max_results).toBeNull();
    for (const c of corpus.conversations) {
      const ns = san.ns(c.id);
      await sys.reset(ns);
      for (const step of san.ingestPlan(c)) await sys.ingestSession(ns, step.input, step.event_time);
      await sys.finishIngest();
      for (const [path, f] of sys.tree(ns).files) { san.assertClean(path, 'file path'); san.assertClean(f.content, 'file text'); }
    }
    await expect(sys.retrieve()).rejects.toThrow(/no passive retrieval/);
    const rows = [];
    for (const q of corpus.questions) {
      const ns = san.ns(q.conversation);
      const a = await sys.answer(ns, san.question(q), { reader: 'scripted', replicate: 0 });
      const gold = q.gold.map(g => san.source(q.conversation, g));
      rows.push({ q, a, ev: evidenceOpened(a.opened_source_ids, gold) });
    }
    const vet = rows.find(r => r.q.id === 'fx-00')!;
    expect(vet.a.outcome).toBe('scored');
    expect(vet.a.stop_reason).toBe('submitted');
    expect(vet.a.text).toContain('85 dollars');
    expect(vet.a.turns).toBe(5);
    expect(vet.a.opened_source_ids).toHaveLength(2);
    expect(vet.a.usage).toEqual({ input: 0, output: 0, cache_read: 0, cache_write: 0 });
    expect(vet.ev).toEqual({ gold: 1, opened_gold: 1, share: 1 });
    for (const r of rows) {
      expect(r.a.outcome).toBe('scored');
      for (const s of r.a.opened_source_ids) expect(san.sessionOf(san.ns(r.q.conversation), s)).toBeDefined();
    }
    expect(sys.limitEvents).toEqual([]);
    await sys.close();
  });

  test('a turn-cap stop at 40 turns is a product failure scored 0 with its stop reason', async () => {
    const sys = new FileAgentSystem({ workDir: join(tmp, 'cap'), scripted: () => () => ({ name: 'list_dir', args: { path: '.' } }) });
    await sys.ingestSession('ns-cap', { source_id: 'src-1', turns: [{ role: 'user', speaker: 'user', content: 'hi' }] }, '2024-01-01T00:00:00');
    const a = await sys.answer('ns-cap', { text: 'what?', query_time: null }, { reader: 'scripted', replicate: 0 });
    expect(FILE_AGENT_MAX_TURNS).toBe(40);
    expect(a.turns).toBe(40);
    expect(a.stop_reason).toBe('turn_cap');
    expect(a.outcome).toBe('retrieval_error');
    expect(a.text).toBe('');
    await sys.close();
  });

  test('the answer tool takes prose and replaces the value-only submit tool', async () => {
    expect(PROSE_ANSWER_TOOL.name).toBe(SUBMIT_TOOL.name);
    expect(JSON.stringify(PROSE_ANSWER_TOOL)).toContain('in prose');
    expect(JSON.stringify(PROSE_ANSWER_TOOL)).not.toContain('value only');
    const arm = new FsArm('file-agent', new FileStore(new Map()), { write: false });
    await expect(runAgent({ model: 'x', system: '', user: '', arm, submitTool: { ...PROSE_ANSWER_TOOL, name: 'answer' }, scripted: () => ({ name: 'submit_answer', args: {} }) })).rejects.toThrow(/must be named submit_answer/);
  });

  test('stop reasons map to outcomes', () => {
    const run = (over: Partial<AgentRun>): AgentRun => ({ model: 'm', final: null, stop: 'error', turns: 1, tools: [], usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, requests: 0 }, usd: 0, ms: 0, model_ms: 0, tool_ms: 0, ...over });
    expect(classifyRun(run({ stop: 'submitted', final: { answer: 'a long prose answer' } }))).toEqual({ text: 'a long prose answer', stop_reason: 'submitted', outcome: 'scored' });
    expect(classifyRun(run({ stop: 'no_tool_call', text: 'prose' })).outcome).toBe('scored');
    expect(classifyRun(run({ stop: 'no_tool_call', text: '' })).outcome).toBe('retrieval_error');
    expect(classifyRun(run({ error: 'provider error 400: {"type":"invalid_request_error","message":"prompt is too long: 1204512 tokens > 1000000 maximum"}' })).stop_reason).toBe('context_overflow');
    expect(classifyRun(run({ error: 'provider error 400: {"code":"context_length_exceeded"}' })).outcome).toBe('retrieval_error');
    expect(classifyRun(run({ error: 'provider error 529: overloaded' }))).toMatchObject({ stop_reason: 'provider_error', outcome: 'reader_error' });
  });

  test('readers: the four frontier models parse; others refuse with an operator message', () => {
    for (const r of FRONTIER_READERS) expect(parseReader(r).model).toBe(r.slice(r.indexOf(':') + 1));
    for (const bad of ['claude-opus-5-5', 'openai:claude-opus-5-5', 'gemini:gemini-3', 'anthropic:claude-unpriced-9']) {
      try { parseReader(bad); throw new Error('accepted'); }
      catch (e) { expect(e).toBeInstanceOf(DecideError); const op = (e as DecideError).op; expect(op.code).toBe('SPEC_INVALID'); expect(op.why.length).toBeGreaterThan(0); expect(op.fix.verify?.length).toBeGreaterThan(0); }
    }
  });

  test('provider calls go to the metering proxy base URLs when set', async () => {
    const seen: string[] = [];
    const f = proxiedFetch({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787/slot/anthropic/', OPENAI_BASE_URL: 'http://127.0.0.1:8787/slot/openai/v1' }, (async (u: string | URL | Request) => { seen.push(String(u)); return new Response('{}'); }) as typeof fetch);
    await f('https://api.anthropic.com/v1/messages');
    await f('https://api.openai.com/v1/responses');
    await proxiedFetch({}, (async (u: string | URL | Request) => { seen.push(String(u)); return new Response('{}'); }) as typeof fetch)('https://api.openai.com/v1/responses');
    expect(seen).toEqual(['http://127.0.0.1:8787/slot/anthropic/v1/messages', 'http://127.0.0.1:8787/slot/openai/v1/responses', 'https://api.openai.com/v1/responses']);
  });
});

describe('true full context', () => {
  const corpus = loadFixture();
  const conv = corpus.conversations[0];
  const q = corpus.questions.find(x => x.conversation === conv.id)!;
  const prompt = readerPrompt(q, conv.sessions, '2026-04-01');

  test('every frontier reader has a window and a price, in one table', () => {
    for (const r of FRONTIER_READERS) { expect(READER_WINDOWS[r]).toBeDefined(); expect(CHAT_PRICE_OVERRIDES[r]).toBeDefined(); }
    expect(READER_WINDOWS['openai:gpt-6.1-sol'].max_input_tokens).toBe(922_000);
  });

  test('fit and refusal against each reader window', () => {
    expect(checkFit('anthropic:claude-sonnet-5-5', prompt, 1024).fits).toBe(true);
    const big = 'x'.repeat(2_850_000);
    expect(checkFit('anthropic:claude-sonnet-5-5', big, 1024)).toMatchObject({ fits: true, prompt_tokens: 950_000 });
    expect(checkFit('openai:gpt-6.1-sol', big, 1024)).toMatchObject({ fits: false, max_input_tokens: 922_000 });
    expect(checkFit('anthropic:claude-opus-5-5', 'x'.repeat(2_997_000), 2000).fits).toBe(false);
    expect(() => checkFit('anthropic:claude-haiku-4-5', prompt, 1024)).toThrow(DecideError);
  });

  test('a history that does not fit is refused before any provider call', async () => {
    let calls = 0;
    const a = await answerFullContext({ reader: 'anthropic:claude-fable-5-1', prompt: 'x'.repeat(3_100_000), conversation: conv.id, fetchImpl: (async () => { calls++; return new Response('{}'); }) as unknown as typeof fetch });
    expect(a.outcome).toBe('does_not_fit');
    expect(a.fit.fits).toBe(false);
    expect(calls).toBe(0);
  });

  test('a provider "too long" rejection is also does_not_fit; other failures are harness failures', async () => {
    const tooLong = (async () => new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'prompt is too long: 1100000 tokens > 1000000 maximum' } }), { status: 400 })) as unknown as typeof fetch;
    expect((await answerFullContext({ reader: 'anthropic:claude-opus-5-5', prompt, conversation: conv.id, fetchImpl: tooLong })).outcome).toBe('does_not_fit');
    const bad = (async () => new Response(JSON.stringify({ error: { message: 'invalid model' } }), { status: 404 })) as unknown as typeof fetch;
    const r = await answerFullContext({ reader: 'anthropic:claude-opus-5-5', prompt, conversation: conv.id, fetchImpl: bad });
    expect(r.outcome).toBe('reader_error');
    expect(r.error).toContain('404');
  });

  test('Anthropic readers cache the history prefix per conversation; the bytes equal the uncached prompt', async () => {
    const bodies: any[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      const n = bodies.length;
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'answer' }], usage: { input_tokens: 20, output_tokens: 5, cache_creation_input_tokens: n === 1 ? 900 : 0, cache_read_input_tokens: n === 1 ? 0 : 900 } }));
    }) as unknown as typeof fetch;
    const q2 = corpus.questions.filter(x => x.conversation === conv.id)[1];
    const p2 = readerPrompt(q2, conv.sessions, '2026-04-01');
    const a1 = await answerFullContext({ reader: 'anthropic:claude-sonnet-5-5', prompt, conversation: conv.id, fetchImpl });
    const a2 = await answerFullContext({ reader: 'anthropic:claude-sonnet-5-5', prompt: p2, conversation: conv.id, fetchImpl });
    const [c1, c2] = bodies.map(b => b.messages[0].content);
    expect(c1[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(c1[1].cache_control).toBeUndefined();
    expect(c1.map((c: any) => c.text).join('')).toBe(prompt);
    expect(c2.map((c: any) => c.text).join('')).toBe(p2);
    expect(c1[0].text).toBe(c2[0].text);
    expect(c1[1].text.startsWith('Current Date: ')).toBe(true);
    expect(a1).toMatchObject({ outcome: 'scored', text: 'answer', usage: { input: 20, output: 5, cache_read: 0, cache_write: 900 }, provider_input_tokens: 920 });
    expect(a2.usage.cache_read).toBe(900);
    expect(a1.cache_key).toBe(a2.cache_key);
    expect(splitForCache('no marker')).toEqual({ prefix: 'no marker', suffix: '' });
  });

  test('OpenAI readers send the same bytes with a per-conversation prompt_cache_key', async () => {
    const bodies: any[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1000, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 896 } } }));
    }) as unknown as typeof fetch;
    const other = corpus.conversations[1];
    const a = await answerFullContext({ reader: 'openai:gpt-6.1-sol', prompt, conversation: conv.id, fetchImpl });
    await answerFullContext({ reader: 'openai:gpt-6.1-sol', prompt, conversation: conv.id, fetchImpl });
    await answerFullContext({ reader: 'openai:gpt-6.1-sol', prompt, conversation: other.id, fetchImpl });
    expect(bodies[0].messages[0].content).toBe(prompt);
    expect(bodies[0].prompt_cache_key).toBe(bodies[1].prompt_cache_key);
    expect(bodies[0].prompt_cache_key).not.toBe(bodies[2].prompt_cache_key);
    expect(bodies[0].prompt_cache_key).not.toContain(conv.id);
    expect(a.usage).toEqual({ input: 104, output: 7, cache_read: 896, cache_write: 0 });
  });

  test('public ids: the shootout full-context system is unchanged; Q1 modes name the kinds', async () => {
    const legacy = await new FullContextSystem().capabilities();
    expect(new FullContextSystem().name).toBe('full-context');
    expect(legacy.system).toBe('full-context');
    expect(Object.keys(legacy)).not.toContain('fit');
    expect(new FullContextSystem('whole-history').name).toBe('baseline-full-context');
    expect(new FullContextSystem('recency').name).toBe('baseline-recency');
    expect((await new FullContextSystem('whole-history').capabilities()).fit).toMatch(/does_not_fit/);
  });
});
