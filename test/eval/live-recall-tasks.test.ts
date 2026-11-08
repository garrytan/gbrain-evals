/**
 * Live recall phase 2 (eval/runner/live-recall/tasks.ts), keyless. The public fixture brain with hash embeddings, plus
 * one page flagged private, and scripted models that answer through the provider wire formats behind the budget
 * ledger's paid-request guard (a fake fetch on a temporary ledger). Nothing here reaches a provider.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetRun, installPaidRequestGuard, readLedger } from '../../eval/runner/budget-ledger.ts';
import { runAgent, type Arm } from '../../eval/runner/cat40/loop.ts';
import { importGbrain, resolveGbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import { LiveRecallAbort, installGuards } from '../../eval/runner/live-recall/brain.ts';
import { isCapStop } from '../../eval/runner/refresh-barrier/ledger.ts';
import { buildFixtureBrain } from '../../eval/runner/live-recall/run.ts';
import { ANSWER_TOOL, PROMPTS, SUMMARY_TOOL, citedSlugs, openReader, runEpisode, type AnswerRecord, type Task } from '../../eval/runner/live-recall/task-arms.ts';
import { JUDGE_SYSTEM, VERDICT_TOOL, assertJudge, derive, judgeFor, parseVerdict, secondJudgeFor } from '../../eval/runner/live-recall/task-judge.ts';
import { checkOutbound, mdd, primaryMdd, taskNeedles, validateTaskScorecard } from '../../eval/runner/live-recall/task-scorecard.ts';
import {
  FIXTURE_TASKS, PHASE2_PAGES, estimateCost, freezeSummary, goldCheck, loadRecords, parseTasks, runTaskSet, scoreRunDir, spread, watchRefusals, type Paid,
} from '../../eval/runner/live-recall/tasks.ts';

const gut = resolveGbrainUnderTest(null);
const fixtureText = readFileSync(FIXTURE_TASKS, 'utf8');
const fixtureTasks = parseTasks(fixtureText).map(t => t.task);
const PRIVATE_SLUG = 'notes/board-compensation';
const CANARY_FORM = 'zebracanary4417';
const CANARY_FACT = 'quokkacanary9902';

const abortCode = async (run: () => unknown) => {
  try { await run(); return 'no abort'; } catch (e) { return e instanceof LiveRecallAbort ? e.code : String(e); }
};

// ─── A scripted provider behind the guard ──────────────────────────────────────────────────────────────────────────

type Wire = 'anthropic' | 'openai' | 'particle';
interface Sent { wire: Wire; url: string; body: any }

/**
 * Answers every request in the provider's own wire format. Agents search (query, then get_page on the gold page) when
 * they have gbrain's tools, then submit; 'oracle' answers with the gold answer and cites the gold page, 'empty' says it
 * does not know. The judge marks facts present when the answer holds the gold answer, and a citation supported when
 * its page was found.
 */
function scriptedProviders(tasks: Task[], opts: { mode?: 'oracle' | 'empty'; particleNoMessage?: boolean } = {}) {
  const mode = opts.mode ?? 'oracle';
  const byQuestion = new Map<string, Task>();
  for (const t of tasks) { byQuestion.set(t.forms.paraphrase, t); byQuestion.set(t.forms.exact, t); }
  const sent: Sent[] = [];
  let n = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (url.endsWith('/embeddings')) return Response.json({ object: 'list', data: (body.input as string[]).map((_, i) => ({ index: i, embedding: [0] })), model: body.model, usage: { prompt_tokens: 8, total_tokens: 8 } });
    const wire: Wire = url.includes('anthropic.com') ? 'anthropic' : url.includes('openai.com') ? 'openai' : 'particle';
    sent.push({ wire, url, body });
    n++;
    const c = conversation(wire, body);
    if (wire === 'particle' && opts.particleNoMessage && c.system !== JUDGE_SYSTEM) return Response.json({ id: 'chatcmpl-x', object: 'chat.completion', model: 'particle-ai/particle-1', choices: [], usage: { prompt_tokens: 10, completion_tokens: 0 } });
    const call = decide(c);
    return Response.json(reply(wire, String(body.model), call, n));
  }) as unknown as typeof fetch;

  function decide(c: ReturnType<typeof conversation>): { name: string; args: Record<string, unknown> } {
    if (c.system === JUDGE_SYSTEM) {
      const quoted = (label: string) => new RegExp(label + ':\\n<<<QUOTED\\n([\\s\\S]*?)\\nQUOTED>>>').exec(c.user)?.[1] ?? '';
      const gold = quoted('Gold answer'), answer = quoted('Answer to grade');
      const ids = [...c.user.matchAll(/^- ([A-Za-z0-9_-]+): <<<QUOTED/gm)].map(m => m[1]);
      const pages = [...c.user.matchAll(/Page \[([^\]]+)\]:\n<<<QUOTED\n([\s\S]*?)\nQUOTED>>>/g)].map(m => ({ slug: m[1], found: m[2] !== '(page not found)' }));
      const right = answer.includes(gold);
      return { name: 'submit_answer', args: { facts: ids.map(id => ({ id, verdict: right ? 'present' : 'missing' })), abstained: !right, citations: pages.map(p => ({ slug: p.slug, verdict: p.found ? 'supported' : 'not_a_page' })) } };
    }
    const question = c.user.startsWith('Question:\n') ? c.user.split('\n')[1]! : c.user;
    const task = byQuestion.get(question);
    if (!task) throw new Error('scripted provider: unknown question');
    const gold = task.gold_pages[0]!;
    if (c.tools.includes('query') && c.results === 0) return { name: 'query', args: { query: question } };
    if (c.tools.includes('query') && c.results === 1) return { name: 'get_page', args: { slug: gold } };
    if (mode === 'empty') return { name: 'submit_answer', args: c.summary ? { summary: 'Nothing found.', sources: [] } : { answer: 'I do not know.', sources: [] } };
    if (c.summary) return { name: 'submit_answer', args: { summary: task.gold_answer.text + ' [' + gold + ']', sources: [gold] } };
    if (c.system === PROMPTS.A) return { name: 'submit_answer', args: { answer: task.gold_answer.text, sources: [] } };
    return { name: 'submit_answer', args: { answer: task.gold_answer.text + ' [' + gold + ']', sources: [gold] } };
  }
  return { fetchImpl, sent };
}

function conversation(wire: Wire, body: any) {
  const props = (schema: any) => Object.keys(schema?.properties ?? {});
  if (wire === 'anthropic') {
    const blocks = (body.messages as any[]).flatMap(m => m.content as any[]);
    const submit = (body.tools as any[]).find(t => t.name === 'submit_answer');
    return { system: (body.system as any[]).map(s => s.text).join(''), user: body.messages[0].content[0].text as string, tools: (body.tools as any[]).map(t => t.name as string), results: blocks.filter(b => b.type === 'tool_result').length, summary: props(submit?.input_schema).includes('summary') };
  }
  if (wire === 'openai') {
    const submit = (body.tools as any[]).find(t => t.name === 'submit_answer');
    return { system: body.instructions as string, user: body.input[0].content as string, tools: (body.tools as any[]).map(t => t.name as string), results: (body.input as any[]).filter(i => i.type === 'function_call_output').length, summary: props(submit?.parameters).includes('summary') };
  }
  const submit = (body.tools as any[]).find(t => t.function.name === 'submit_answer');
  return { system: body.messages[0].content as string, user: body.messages[1].content as string, tools: (body.tools as any[]).map(t => t.function.name as string), results: (body.messages as any[]).filter(m => m.role === 'tool').length, summary: props(submit?.function.parameters).includes('summary') };
}

function reply(wire: Wire, model: string, call: { name: string; args: Record<string, unknown> }, n: number) {
  const args = JSON.stringify(call.args);
  if (wire === 'anthropic') return { id: 'msg_' + n, type: 'message', role: 'assistant', model, content: [{ type: 'tool_use', id: 'toolu_' + n, name: call.name, input: call.args }], stop_reason: 'tool_use', usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
  if (wire === 'openai') return { id: 'resp_' + n, object: 'response', model, status: 'completed', output: [{ type: 'reasoning', id: 'rs_' + n, encrypted_content: 'opaque', summary: [] }, { type: 'function_call', id: 'fc_' + n, call_id: 'call_' + n, name: call.name, arguments: args }], usage: { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 0 } } };
  return { id: 'chatcmpl-' + n, object: 'chat.completion', model: 'particle-ai/particle-1', service_tier: 'default', system_fingerprint: 'fp_x', metadata: { weight_version: 'default' }, choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_' + n, type: 'function', function: { name: call.name, arguments: args } }] } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } };
}

/** A guarded ledger run on a temporary ledger, with the scripted provider as the guard's only way out. */
function scriptedPaid(dir: string, fetchImpl: typeof fetch, capUsd: number): Paid {
  const ledgerPath = join(dir, 'ledger.sqlite');
  const run = BudgetRun.open({ runner: 'live-recall-phase2-test', budgetUsd: capUsd, ledgerPath, programCapUsd: 100 });
  return { run, guard: installPaidRequestGuard(run, { fetchImpl }), runner: 'live-recall-phase2-test', capUsd, ledgerPath };
}

const savedKey = process.env.PARTICLE_API_KEY;
beforeAll(() => { process.env.PARTICLE_API_KEY ??= 'scripted'; });
afterAll(() => { if (savedKey === undefined) delete process.env.PARTICLE_API_KEY; else process.env.PARTICLE_API_KEY = savedKey; });

// ─── Task file and freeze ──────────────────────────────────────────────────────────────────────────────────────────

describe('phase 2 task file', () => {
  test('the fixture parses: twenty public tasks and one whose gold page is private', () => {
    expect(fixtureTasks).toHaveLength(21);
    expect(fixtureTasks.filter(t => t.gold_pages.includes(PRIVATE_SLUG))).toHaveLength(1);
  });

  test('an invalid line aborts with its line and field, never its content', async () => {
    const lines = fixtureText.trim().split('\n');
    const bad = JSON.parse(lines[2]!);
    bad.gold_answer.required_facts = [];
    bad.forms.exact = CANARY_FORM;
    const text = [lines[0], lines[1], JSON.stringify(bad)].join('\n');
    let error: unknown;
    try { parseTasks(text); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(LiveRecallAbort);
    expect((error as LiveRecallAbort).code).toBe('LR_TASKS_INVALID');
    expect((error as LiveRecallAbort).detail).toBe('line 3 field gold_answer.required_facts');
    expect(String(error)).not.toContain(CANARY_FORM);
    const dup = [lines[0], lines[0]].join('\n');
    expect(await abortCode(() => parseTasks(dup))).toBe('LR_TASKS_INVALID');
  });

  test('MDD for the four primaries matches the preregistration', () => {
    expect(primaryMdd(100).pd20).toEqual({ alpha_05: 0.1253, holm_0125: 0.1493 });
    expect(primaryMdd(60).pd20).toEqual({ alpha_05: 0.1617, holm_0125: 0.1928 });
    expect(mdd(0, 0.2)).toBeNull();
  });
});

// ─── Privacy posture ───────────────────────────────────────────────────────────────────────────────────────────────

describe('phase 2 privacy posture on the fixture (keyless)', () => {
  let brain: Awaited<ReturnType<typeof buildFixtureBrain>>;
  let reader: Awaited<ReturnType<typeof openReader>>;
  beforeAll(async () => {
    brain = await buildFixtureBrain(gut, PHASE2_PAGES);
    installGuards(brain.engine, { refusals: {} });
    reader = await openReader(gut, brain.engine, true);
  }, 120_000);
  afterAll(async () => { await brain?.close(); });

  test('the private page is unreachable to B and C\'s tools, D\'s search and the judge\'s page reads', async () => {
    expect(await reader.reachable(PRIVATE_SLUG)).toBe(false);
    expect(await reader.page(PRIVATE_SLUG)).toBeNull();
    for (const q of ['executive bonus pool board 2027', 'board compensation decision']) {
      for (const tool of ['query', 'search'] as const) {
        const r = await reader.call(tool, { query: q });
        expect(r.isError).toBe(false);
        expect(r.text).not.toContain(PRIVATE_SLUG);
        expect(r.text).not.toContain('12 percent of salary');
      }
      expect((await reader.top(q)).slugs).not.toContain(PRIVATE_SLUG);
    }
    expect(await reader.reachable('projects/project-heron')).toBe(true);
  });

  test('freeze drops the task whose gold page is private and counts it', async () => {
    const parsed = parseTasks(fixtureText);
    const { kept, dropped } = await goldCheck(reader, parsed);
    expect(dropped).toBe(1);
    const summary = freezeSummary(fixtureText, parsed, kept, gut);
    expect([summary.n_submitted, summary.n_kept, summary.dropped_unreachable]).toEqual([21, 20, 1]);
    expect(summary.kept_lines).not.toContain(parsed.find(t => t.task.gold_pages.includes(PRIVATE_SLUG))!.line);
    expect(JSON.stringify(summary)).not.toContain(PRIVATE_SLUG);
  });

  test('B\'s tools are gbrain\'s query, search and get_page, with expansion and images removed', () => {
    expect(reader.tools.map(t => t.name).sort()).toEqual(['get_page', 'query', 'search']);
    for (const t of reader.tools) for (const k of ['expand', 'image', 'image_mime']) expect(Object.keys((t.input_schema as any).properties)).not.toContain(k);
  });

  test('writes allowed and writes refused return the same results for every fixture query', async () => {
    const open = await buildFixtureBrain(gut, PHASE2_PAGES);
    try {
      await open.engine.executeRaw('SET default_transaction_read_only = off');
      const unguarded = await openReader(gut, open.engine, true);
      for (const t of fixtureTasks) for (const q of [t.forms.paraphrase, t.forms.exact]) {
        const [a, b] = [await reader.call('query', { query: q }), await unguarded.call('query', { query: q })];
        const slugs = (text: string) => [...text.matchAll(/"slug"\s*:\s*"([^"]+)"/g)].map(m => m[1]);
        expect(slugs(a.text)).toEqual(slugs(b.text));
      }
    } finally { await open.close(); }
  }, 120_000);

  test('a failing embedding marks the episode degraded instead of counting a keyword-only answer', async () => {
    const gateway = await importGbrain<any>(gut, 'src/core/ai/gateway.ts');
    const task = fixtureTasks[0]!;
    const { fetchImpl } = scriptedProviders(fixtureTasks);
    const dir = mkdtempSync(join(tmpdir(), 'lr2-degraded-'));
    const paid = scriptedPaid(dir, fetchImpl, 5);
    try {
      gateway.__setEmbedTransportForTests(async () => { throw new Error('embedding service down'); });
      const ctx = { reader, limit: <T>(_m: string, f: () => Promise<T>) => f(), capCheck: () => {} };
      expect((await runEpisode(ctx, task, 'paraphrase', 'B', 'claude-opus-5-5', 1)).status).toBe('degraded');
      expect((await runEpisode(ctx, task, 'paraphrase', 'D', 'claude-opus-5-5', 1)).status).toBe('degraded');
      expect((await runEpisode(ctx, task, 'paraphrase', 'A', 'claude-opus-5-5', 1)).status).toBe('answered');
    } finally {
      const { hashEmbedVector } = await import('../../eval/runner/cat18-embedding-providers.ts');
      gateway.__setEmbedTransportForTests(async (params: { values: string[] }) => ({ embeddings: params.values.map(v => hashEmbedVector(v, 256)), values: params.values, warnings: [] }));
      paid.guard.uninstall();
      paid.run.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('a pass-through reranker marks D degraded', async () => {
    const gateway = await importGbrain<any>(gut, 'src/core/ai/gateway.ts');
    const { makeOverlapRerankTransport } = await import('../../eval/runner/cat18b-embedding-rerank-matrix.ts');
    try {
      gateway.__setRerankTransportForTests(async () => { throw new Error('reranker down'); });
      const top = await reader.top(fixtureTasks[0]!.forms.paraphrase);
      expect(top.degraded.some(s => s === 'rerank_failed' || s === 'rerank_passthrough')).toBe(true);
    } finally { gateway.__setRerankTransportForTests(makeOverlapRerankTransport()); }
  }, 60_000);

  test('a cap refusal inside a gbrain embedding call is a cap stop, never a keyword-only episode', async () => {
    const gateway = await importGbrain<any>(gut, 'src/core/ai/gateway.ts');
    const { hashEmbedVector } = await import('../../eval/runner/cat18-embedding-providers.ts');
    const { fetchImpl } = scriptedProviders(fixtureTasks);
    const dir = mkdtempSync(join(tmpdir(), 'lr2-embedcap-'));
    const run = BudgetRun.open({ runner: 'embed-cap', budgetUsd: 1e-9, ledgerPath: join(dir, 'ledger.sqlite'), programCapUsd: 100 });
    const guard = installPaidRequestGuard(run, { fetchImpl });
    const watch = watchRefusals();
    try {
      gateway.__setEmbedTransportForTests(async (params: { values: string[] }) => {
        await fetch('https://api.openai.com/v1/embeddings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'text-embedding-3-small', input: params.values }) });
        return { embeddings: params.values.map(v => hashEmbedVector(v, 256)), values: params.values, warnings: [] };
      });
      const capped = await openReader(gut, brain.engine, true, watch.capped);
      let error: unknown;
      try { await runEpisode({ reader: capped, limit: (_m, f) => f(), capCheck: watch.check }, fixtureTasks[0]!, 'paraphrase', 'D', 'claude-opus-5-5', 1); } catch (e) { error = e; }
      expect(isCapStop(error)).toBe(true);
    } finally {
      gateway.__setEmbedTransportForTests(async (params: { values: string[] }) => ({ embeddings: params.values.map(v => hashEmbedVector(v, 256)), values: params.values, warnings: [] }));
      watch.restore();
      guard.uninstall();
      run.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

// ─── Judge ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('phase 2 judge', () => {
  test('routing: Sol judges Opus and particle-1, Opus judges Sol, particle-1 never judges, no family judges itself', () => {
    expect(judgeFor('claude-opus-5-5')).toBe('gpt-6.1-sol');
    expect(judgeFor('particle-1')).toBe('gpt-6.1-sol');
    expect(judgeFor('gpt-6.1-sol')).toBe('claude-opus-5-5');
    expect(secondJudgeFor('particle-1')).toBe('claude-opus-5-5');
    expect(secondJudgeFor('claude-opus-5-5')).toBeNull();
    expect(() => assertJudge('particle-1', 'claude-opus-5-5')).toThrow('never judges');
    expect(() => assertJudge('gpt-6.1-sol', 'gpt-6.1-sol')).toThrow('same family');
    expect(() => assertJudge('claude-opus-5-5', 'claude-opus-5-5')).toThrow('same family');
  });

  test('verdicts: correct needs every fact, grounded needs every citation supported, an unjudged citation is unsupported', () => {
    const v = parseVerdict({ facts: [{ id: 'f1', verdict: 'present' }, { id: 'f2', verdict: 'present' }], abstained: false, citations: [{ slug: '[a/b]', verdict: 'supported' }] }, ['f1', 'f2'], ['a/b'])!;
    expect(derive(v, ['a/b'])).toMatchObject({ correct: true, grounded: true, citations: 1, supported: 1 });
    expect(derive(v, ['a/b', 'c/d'])).toMatchObject({ correct: true, grounded: false, citations: 2, supported: 1 });
    expect(derive(v, [])).toMatchObject({ grounded: false });
    const partial = parseVerdict({ facts: [{ id: 'f1', verdict: 'present' }, { id: 'f2', verdict: 'contradicted' }], abstained: false, citations: [] }, ['f1', 'f2'], [])!;
    expect(derive(partial, [])).toMatchObject({ correct: false, partial: true, contradicted: true });
    expect(parseVerdict({ facts: [{ id: 'f1', verdict: 'present' }], abstained: false, citations: [] }, ['f1', 'f2'], [])).toBeNull();
    expect(parseVerdict({ facts: [{ id: 'f1', verdict: 'present' }], abstained: false, citations: [] }, ['f1'], ['a/b'])).toBeNull();
    expect(parseVerdict('not an object', ['f1'], [])).toBeNull();
  });

  test('citations: inline markers then the sources list, deduplicated, numbers and spaces dropped', () => {
    expect(citedSlugs('Heron [projects/project-heron] and [1] and [people/maya-okafor].', ['[people/maya-okafor]', 'notes/x', 'has space'])).toEqual(['projects/project-heron', 'people/maya-okafor', 'notes/x']);
  });
});

// ─── The loop's stateless OpenAI option ────────────────────────────────────────────────────────────────────────────

describe('Cat 40 loop, openaiStore false', () => {
  test('every OpenAI request sends store false and resends the accumulated input instead of chaining', async () => {
    const bodies: any[] = [];
    let turn = 0;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      turn++;
      const call = turn === 1 ? { name: 'lookup', args: '{"key":"a"}' } : { name: 'submit_answer', args: '{"answer":"42","sources":[]}' };
      return Response.json({ id: 'resp_' + turn, status: 'completed', output: [{ type: 'reasoning', id: 'rs_' + turn, encrypted_content: 'opaque' }, { type: 'function_call', call_id: 'call_' + turn, name: call.name, arguments: call.args }], usage: { input_tokens: 10, output_tokens: 5 } });
    }) as unknown as typeof fetch;
    const arm: Arm = { name: 't', systemHint: () => '', writeTools: () => [], tools: () => [{ name: 'lookup', description: 'Look up.', input_schema: { type: 'object', properties: { key: { type: 'string' } } } }], call: async () => 'value' };
    const run = await runAgent({ model: 'gpt-6.1-sol', system: 's', user: 'u', arm, fetchImpl, openaiStore: false, effort: 'medium' });
    expect(run.stop).toBe('submitted');
    expect(bodies).toHaveLength(2);
    for (const b of bodies) {
      expect(b.store).toBe(false);
      expect(b.include).toEqual(['reasoning.encrypted_content']);
      expect(b.previous_response_id).toBeUndefined();
    }
    expect(bodies[1].input.map((i: any) => i.type ?? i.role)).toEqual(['user', 'reasoning', 'function_call', 'function_call_output']);
  });
});

// ─── A full fixture run ────────────────────────────────────────────────────────────────────────────────────────────

describe('phase 2 fixture run with scripted models (keyless)', () => {
  let dir: string;
  let tasksPath: string;
  let tasks: Task[];
  let providers: ReturnType<typeof scriptedProviders>;
  let result: Awaited<ReturnType<typeof runTaskSet>>;
  let card: any;
  let markdown: string;
  const terminal: string[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lr2-run-'));
    process.env.GBRAIN_AUDIT_DIR = dir;
    const lines = fixtureText.trim().split('\n').map(l => JSON.parse(l));
    lines[0].forms.paraphrase += ' ' + CANARY_FORM;
    lines[0].gold_answer.required_facts[0].fact += ' ' + CANARY_FACT;
    lines[1].gold_answer.required_facts.push({ id: 'f9', fact: '12' });
    tasksPath = join(dir, 'tasks.jsonl');
    writeFileSync(tasksPath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    tasks = parseTasks(readFileSync(tasksPath, 'utf8')).map(t => t.task);
    providers = scriptedProviders(tasks);
    const paid = scriptedPaid(dir, providers.fetchImpl, 9);
    try {
      result = await runTaskSet({
        out: join(dir, 'run'), gut, fixture: true, tasksPath, freezePath: null, databaseUrlEnv: 'UNUSED', forms: ['paraphrase', 'exact'], arms: ['A', 'B', 'C', 'D'],
        models: ['claude-opus-5-5', 'gpt-6.1-sol', 'particle-1'], limit: 5, concurrency: 3, resume: false, windowNote: null, paid,
      }, line => terminal.push(line));
    } finally { paid.guard.uninstall(); paid.run.close({ finish: false }); }
    card = JSON.parse(readFileSync(result.scorecard, 'utf8'));
    markdown = readFileSync(result.markdown, 'utf8');
  }, 300_000);
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test('runs every arm, model and form to a complete, valid scorecard', () => {
    expect(result.result).toBe('complete');
    expect(() => validateTaskScorecard(card)).not.toThrow();
    expect(card.status).toBe('complete');
    expect(card.run.control).toBe(true);
    expect(card.run.privacy_posture).toBe('remote');
    expect(card.run.openai_store).toBe(false);
    expect(card.tasks).toMatchObject({ submitted: 21, kept_at_freeze: 20, dropped_unreachable: 1, kept_at_run: 5 });
    for (const form of ['paraphrase', 'exact', 'pooled']) for (const arm of ['A', 'B', 'C', 'D']) for (const model of ['claude-opus-5-5', 'gpt-6.1-sol', 'particle-1']) {
      expect(card.cells[form][arm][model].counted).toBe(form === 'pooled' ? 10 : 5);
    }
  });

  test('an oracle answerer scores 1.0, grounded where it cites, and exposure shows the gold page searched and opened', () => {
    for (const arm of ['A', 'B', 'C', 'D']) expect(card.cells.paraphrase[arm]['claude-opus-5-5'].rates.correct.point).toBe(1);
    expect(card.cells.paraphrase.A['particle-1'].rates.correct_grounded).toBeNull();
    for (const arm of ['B', 'C', 'D']) expect(card.cells.paraphrase[arm]['particle-1'].rates.correct_grounded.point).toBe(1);
    expect(card.cells.paraphrase.B['gpt-6.1-sol'].exposure.gold_opened).toBe(1);
    expect(card.cells.paraphrase.C['gpt-6.1-sol'].exposure.summary_gold_cited).toBe(1);
    expect(card.comparisons.filter((c: any) => c.primary).map((c: any) => c.id).sort()).toEqual(['p1_b_vs_a_opus', 'p1_b_vs_a_particle', 'p2_c_vs_b_opus', 'p2_c_vs_b_particle']);
  });

  test('the paraphrase pass finishes before the exact pass starts', () => {
    const answers = loadRecords(join(dir, 'run', 'records.local.jsonl')).records.filter((r): r is AnswerRecord => r.kind === 'answer');
    const lastParaphrase = answers.map(a => a.form).lastIndexOf('paraphrase');
    const firstExact = answers.map(a => a.form).indexOf('exact');
    expect(firstExact).toBeGreaterThan(lastParaphrase);
  });

  test('every OpenAI request, agents and judges, sends store false; judges route by family', () => {
    const openai = providers.sent.filter(s => s.wire === 'openai');
    expect(openai.length).toBeGreaterThan(0);
    for (const s of openai) { expect(s.body.store).toBe(false); expect(s.body.previous_response_id).toBeUndefined(); }
    const judged = (wire: Wire) => providers.sent.filter(s => s.wire === wire && conversation(wire, s.body).system === JUDGE_SYSTEM);
    expect(judged('particle')).toHaveLength(0);
    const records = loadRecords(join(dir, 'run', 'records.local.jsonl')).records;
    for (const j of records) if (j.kind !== 'answer') {
      const model = j.key.split('|')[3]!;
      expect(j.judge).toBe(j.kind === 'judge' ? judgeFor(model) : 'claude-opus-5-5');
      if (j.kind === 'judge2') expect([model, j.key.split('|')[0], ['B', 'C', 'D'].includes(j.key.split('|')[2]!)]).toEqual(['particle-1', 'paraphrase', true]);
    }
  });

  test('cost: the scorecard\'s model-call total reconciles with the ledger at list prices', () => {
    const ledger = readLedger(join(dir, 'ledger.sqlite')).entries.reduce((s, e) => s + (e.actual_usd ?? e.reserved_usd), 0);
    expect(card.cost.ledger_usd).toBeCloseTo(ledger, 4);
    expect(card.cost.model_calls_usd).toBeCloseTo(ledger, 3);
    expect(card.cost.model_calls_usd).toBeGreaterThan(0);
  });

  test('no task form, gold fact or slug reaches the scorecard or the terminal; a numeric fact is no false positive', () => {
    const out = JSON.stringify(card) + markdown + terminal.join('\n');
    for (const needle of [CANARY_FORM, CANARY_FACT, 'projects/project-heron', tasks[0]!.forms.exact]) expect(out).not.toContain(needle);
    const needles = taskNeedles(tasks, loadRecords(join(dir, 'run', 'records.local.jsonl')).records);
    expect(needles).not.toContain('12');
    expect(needles).toContain('projects/project-heron');
    const leaked = JSON.stringify({ ...card, run: { ...card.run, window_note: 'projects/project-heron' } });
    expect(() => checkOutbound(leaked, markdown, needles)).toThrow('LR_CUSTODY_LEAK');
    expect(() => checkOutbound(JSON.stringify(card), markdown + ' ' + tasks[0]!.gold_answer.required_facts[0]!.fact, needles)).toThrow('LR_CUSTODY_LEAK');
  });

  test('score re-runs from the run directory alone and gives the same scorecard', () => {
    const again = scoreRunDir(join(dir, 'run'));
    expect(JSON.parse(readFileSync(again.scorecard, 'utf8'))).toEqual(card);
  });

  test('resume judges an answered but unjudged episode without re-answering it', async () => {
    const path = join(dir, 'run', 'records.local.jsonl');
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    const dropped = lines.filter(l => JSON.parse(l).kind === 'judge').slice(0, 3);
    writeFileSync(path, lines.filter(l => !dropped.includes(l)).join('\n') + '\n');
    const before = providers.sent.length;
    const ledger = join(dir, 'ledger.sqlite');
    const run = BudgetRun.open({ runner: 'live-recall-phase2-resume', budgetUsd: 1, ledgerPath: ledger, programCapUsd: 100 });
    const paid: Paid = { run, guard: installPaidRequestGuard(run, { fetchImpl: providers.fetchImpl }), runner: 'live-recall-phase2-resume', capUsd: 1, ledgerPath: ledger };
    try {
      const again = await runTaskSet({
        out: join(dir, 'run'), gut, fixture: true, tasksPath, freezePath: null, databaseUrlEnv: 'UNUSED', forms: ['paraphrase', 'exact'], arms: ['A', 'B', 'C', 'D'],
        models: ['claude-opus-5-5', 'gpt-6.1-sol', 'particle-1'], limit: 5, concurrency: 3, resume: true, windowNote: null, paid,
      }, () => {});
      expect(again.result).toBe('complete');
    } finally { paid.guard.uninstall(); run.close(); }
    const made = providers.sent.slice(before);
    expect(made).toHaveLength(3);
    expect(made.every(s => conversation(s.wire, s.body).system === JUDGE_SYSTEM)).toBe(true);
  }, 120_000);

  test('a counted resume without a window note, a changed task file and an unfrozen run abort with their codes', async () => {
    const paid = {} as Paid;
    const base = { out: join(dir, 'run'), gut, fixture: false, tasksPath, databaseUrlEnv: 'UNUSED', forms: ['paraphrase'] as any, arms: ['A'] as any, models: ['claude-opus-5-5'], limit: null, concurrency: 1, windowNote: null, paid };
    expect(await abortCode(() => runTaskSet({ ...base, freezePath: null, resume: true }, () => {}))).toBe('LR_RESUME_NEEDS_WINDOW');
    const fresh = join(dir, 'fresh');
    expect(await abortCode(() => runTaskSet({ ...base, out: fresh, freezePath: null, resume: false }, () => {}))).toBe('LR_FREEZE_MISMATCH');
    const freezePath = join(dir, 'freeze.json');
    writeFileSync(freezePath, JSON.stringify({ schema: 'live-recall-task-freeze/v1', tasks_sha256: '0'.repeat(64) }));
    expect(await abortCode(() => runTaskSet({ ...base, out: fresh, freezePath, resume: false }, () => {}))).toBe('LR_FREEZE_MISMATCH');
  });
});

// ─── Stops ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('phase 2 stops (keyless)', () => {
  test('a tiny budget ends in LR_CAP_STOP with an incomplete scorecard, and the run never reruns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lr2-cap-'));
    process.env.GBRAIN_AUDIT_DIR = dir;
    const providers = scriptedProviders(fixtureTasks);
    const paid = scriptedPaid(dir, providers.fetchImpl, 0.5);
    const opts = { out: join(dir, 'run'), gut, fixture: true, tasksPath: FIXTURE_TASKS, freezePath: null, databaseUrlEnv: 'UNUSED', forms: ['paraphrase', 'exact'] as any, arms: ['A', 'B', 'C', 'D'] as any, models: ['claude-opus-5-5', 'gpt-6.1-sol', 'particle-1'], limit: 5, concurrency: 2, windowNote: null, paid };
    try {
      const r = await runTaskSet({ ...opts, resume: false }, () => {});
      expect(r.result).toBe('cap_stop');
      const card = JSON.parse(readFileSync(r.scorecard, 'utf8'));
      expect([card.status, card.stop]).toEqual(['incomplete', 'LR_CAP_STOP']);
      expect(providers.sent.length).toBeGreaterThan(0);
      const sent = providers.sent.length;
      expect(await abortCode(() => runTaskSet({ ...opts, resume: true }, () => {}))).toBe('LR_CAP_STOP');
      expect(providers.sent.length).toBe(sent);
    } finally {
      paid.guard.uninstall();
      paid.run.close({ finish: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  test('an empty answerer scores 0.0; a particle-1 answer that may have billed is excluded and never rerun', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lr2-empty-'));
    process.env.GBRAIN_AUDIT_DIR = dir;
    const providers = scriptedProviders(fixtureTasks, { mode: 'empty', particleNoMessage: true });
    const paid = scriptedPaid(dir, providers.fetchImpl, 5);
    const opts = { out: join(dir, 'run'), gut, fixture: true, tasksPath: FIXTURE_TASKS, freezePath: null, databaseUrlEnv: 'UNUSED', forms: ['paraphrase'] as any, arms: ['A', 'B'] as any, models: ['claude-opus-5-5', 'particle-1'], limit: 3, concurrency: 2, windowNote: null, paid };
    try {
      const r = await runTaskSet({ ...opts, resume: false }, () => {});
      const card = JSON.parse(readFileSync(r.scorecard, 'utf8'));
      expect(card.cells.paraphrase.A['claude-opus-5-5'].rates.correct.point).toBe(0);
      expect(card.cells.paraphrase.B['claude-opus-5-5'].rates.correct.point).toBe(0);
      expect(card.cells.paraphrase.A['particle-1'].excluded.timed_out).toBe(3);
      expect(card.cells.paraphrase.A['particle-1'].counted).toBe(0);
      const particleCalls = providers.sent.filter(s => s.wire === 'particle').length;
      await runTaskSet({ ...opts, resume: true }, () => {});
      expect(providers.sent.filter(s => s.wire === 'particle').length).toBe(particleCalls);
    } finally {
      paid.guard.uninstall();
      paid.run.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);
});

// ─── Preregistration ──────────────────────────────────────────────────────────────────────────────────────────────

describe('phase 2 preregistration', () => {
  test('carries every prompt, both answer tools, the verdict tool and the judge prompt verbatim', () => {
    const doc = readFileSync(join(import.meta.dir, '../../docs/benchmarks/live-recall/PHASE2-PREREGISTRATION.md'), 'utf8');
    for (const p of Object.values(PROMPTS)) expect(doc).toContain(p);
    expect(doc).toContain(JUDGE_SYSTEM);
    for (const t of [ANSWER_TOOL, SUMMARY_TOOL, VERDICT_TOOL]) expect(doc).toContain(JSON.stringify(t, null, 2));
  });
});

// ─── Estimate ──────────────────────────────────────────────────────────────────────────────────────────────────────

describe('phase 2 cost estimate', () => {
  const usage = (input: number, output: number) => ({ input, output, cache_read: 0, cache_write: 0, requests: 1 });
  const smoke = (): Array<any> => {
    const out: any[] = [];
    for (const arm of ['A', 'B', 'C', 'D']) for (const model of ['claude-opus-5-5', 'gpt-6.1-sol', 'particle-1']) {
      const key = ['paraphrase', 't1', arm, model].join('|');
      out.push({ kind: 'answer', key, arm, model, roles: { answer: { usage: usage(1000, 500) }, ...(arm === 'C' ? { summariser: { usage: usage(4000, 500) } } : {}) } });
      out.push({ kind: 'judge', key, usage: usage(2000, 500) });
      if (model === 'particle-1' && arm !== 'A') out.push({ kind: 'judge2', key, usage: usage(2000, 500) });
    }
    return out;
  };
  test('scales page-reading input by the page-size ratio and applies the 75% paraphrase gate', () => {
    const same = estimateCost(smoke(), 2000, 2000, 100, 2, 360);
    expect(same.page_factor).toEqual({ tool_result: 1, paste: 1, judge: 1 });
    expect(same.passed).toBe(true);
    const big = estimateCost(smoke(), 2000, 8000, 100, 2, 360);
    expect(big.page_factor).toEqual({ tool_result: 4, paste: 4, judge: 4 });
    expect(big.total_usd).toBeGreaterThan(same.total_usd);
    expect(estimateCost(smoke(), 2000, 2000, 100_000, 2, 360).passed).toBe(false);
    expect(() => estimateCost(smoke().filter(r => !(r.kind === 'answer' && r.arm === 'D')), 2000, 2000, 100, 2, 360)).toThrow('no episode for arm D');
  });
  test('spread takes tasks across the five types in turn', () => {
    expect(spread(fixtureTasks, 5).map(t => t.type)).toEqual(['identifier', 'error_string', 'time_window', 'cross_source', 'topic']);
  });
});
